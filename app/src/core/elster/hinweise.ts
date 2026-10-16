/**
 * Hinweise / Einblicke: contextual, data-derived advisory notices — the kind of helpful
 * prompt other tools (e.g. Papierkram) show, e.g. the §19 Kleinunternehmer threshold
 * check. All hints are computed from figures we already have; nothing is filed or changed.
 *
 * Each hint carries a level (warnung > tipp > info) so the view can sort by urgency, and
 * an optional legal reference. Read-only.
 *
 * A check can also say WHAT it found and what to do about it (Idee 4 in docs/ideen-nutzerfuehrung.md):
 * the affected bookings/documents, the actions a frontend offers, and a status — so a check that ran
 * and found nothing says so ("ohne Befund") and one that could not run says why ("nicht prüfbar,
 * weil …") instead of staying silent. All of it is optional; a hint with only title + text is still a
 * valid hint. A hint changes nothing: every action is its own click. Wording: „vermutlich",
 * „zu klären" — never „Fehler" or „Betrug".
 */

import { fmtDe as fmt } from '../lib/money.ts';
import { _, _n, fmt as t } from '../lib/i18n.ts';

export type HinweisLevel = 'warnung' | 'tipp' | 'info';

/** `befund` = something to look at · `ohne_befund` = checked, nothing found · `nicht_pruefbar` = could not check. */
export type HinweisStatus = 'befund' | 'ohne_befund' | 'nicht_pruefbar';

/** One affected booking, document or invoice — a short display line plus the id to open it by. */
export interface HinweisBetroffen {
    art: 'buchung' | 'beleg' | 'rechnung';
    id: string;
    /** „DD.MM.YYYY · −42,00 € · Gegenseite" — ready to show. */
    zeile: string;
}

/** Views a hint can send the user to; each frontend maps them onto its own navigation. */
export type HinweisAnsicht = 'buchungen' | 'beleg-eingang' | 'konten' | 'rechnungen' | 'anlagen';

/** Dialogs a hint can open; `ref` names the subject (booking id, invoice id, account key). */
export type HinweisDialog =
    | 'buchung'
    | 'beleg'
    | 'beleg-zuordnen'
    | 'regel-anlegen'
    | 'rechnung'
    | 'kontoauszug-import'
    | 'anlagegut-erfassen';

/** What the „Ins Anlageverzeichnis" dialog starts with — the owner still confirms every field. */
export interface AnlagegutVorbelegung {
    bezeichnung: string;
    /** YYYY-MM-DD — the first payment. */
    anschaffung: string;
    /** Anschaffungskosten as the check measured them (net, or gross without Vorsteuerabzug). */
    ahk: number;
    /** The bookings that paid it — stored with the asset so the check knows it is captured. */
    buchungIds: string[];
}

/**
 * Where an action leads — frontend-agnostic. `ansicht` navigates, `dialog` opens a detail or editor
 * for one subject, `aktion` calls a core action (today only the generic dismissal).
 */
export type HinweisZiel =
    | { art: 'ansicht'; ansicht: HinweisAnsicht; filter?: 'unklassifiziert' | 'ohne-beleg' | 'forderungen' }
    | { art: 'dialog'; dialog: HinweisDialog; ref?: string; vorbelegung?: AnlagegutVorbelegung }
    | { art: 'aktion'; aktion: 'hinweis-ok' };

export interface HinweisHandlung {
    /** Stable id (`zuordnen`, `in-ordnung`, …) — tests and the devtools rig find the button by it. */
    id: string;
    /** German button label, e.g. „Zuordnen". */
    label: string;
    target: HinweisZiel;
}

export interface Hinweis {
    key: string;
    level: HinweisLevel;
    title: string;
    text: string;
    /** Optional legal reference, e.g. "§ 19 Abs. 1 UStG". */
    ref?: string;
    /** Absent on the plain informational hints; set by every check that can find something. */
    status?: HinweisStatus;
    /** For `ohne_befund`: what was checked and what was ruled out. */
    geprueft?: string;
    /** For `nicht_pruefbar`: the reason, phrased to follow „Nicht prüfbar, weil …". */
    weil?: string;
    /** The affected bookings/documents (at most {@link BETROFFEN_MAX}; the rest is counted). */
    betroffen?: HinweisBetroffen[];
    /** How many affected items did not fit into `betroffen`. */
    betroffenWeitere?: number;
    handlungen?: HinweisHandlung[];
    /** Identifies THIS finding (e.g. its affected ids) — a dismissal holds only while it matches. */
    fingerprint?: string;
    /** Sorted above every other hint, whatever its level or amount (IBAN-Wechsel: money may leave for good). */
    vorrang?: true;
    /** Glossary term (`core/lib/glossary.ts`) the card offers a „?" for. */
    begriff?: string;
}

/** List length a hint carries; the remainder is a count, so a 400-booking hint stays readable. */
export const BETROFFEN_MAX = 20;

/**
 * The generic dismissal every finding with a {@link Hinweis.fingerprint} can offer.
 *
 * A function, not a constant: a constant is built when the module is imported, which can be before
 * the frontend registers its translator — and a label resolved too early stays English for good.
 */
export function handlungInOrdnung(): HinweisHandlung {
    return {
        id: 'in-ordnung',
        label: _('Mark as fine'),
        target: { art: 'aktion', aktion: 'hinweis-ok' },
    };
}

/**
 * Stable short fingerprint of a finding's parts (FNV-1a over the sorted parts). Order-independent, so
 * the same affected bookings give the same print; one more booking gives a new one — and the
 * dismissed hint comes back.
 */
export function hinweisFingerprint(parts: readonly string[]): string {
    let h = 0x811c9dc5;
    for (const ch of [...parts].sort().join('\n')) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/** A booking as one display line: „DD.MM.YYYY · −42,00 € · Gegenseite". */
export function buchungZeile(t: {
    bookingDate: string;
    amount: number;
    counterparty?: string;
    purpose?: string;
}): string {
    const who = t.counterparty?.trim() || t.purpose?.trim() || '—';
    return `${deDate(t.bookingDate)} · ${fmt(t.amount)} € · ${who}`;
}

/** An incoming invoice as one display line: „DD.MM.YYYY · 42,00 € · Absender · Nr. 123". */
export function belegZeile(d: {
    created: string | null;
    gross: number | null;
    correspondent: string | null;
    invoiceNumber?: string | null;
}): string {
    const parts = [d.created ? deDate(d.created) : _('no date')];
    if (d.gross != null) parts.push(`${fmt(d.gross)} €`);
    parts.push(d.correspondent?.trim() || '—');
    if (d.invoiceNumber) parts.push(t(_('no. {number}'), { number: d.invoiceNumber }));
    return parts.join(' · ');
}

/** Cap a list of affected items at {@link BETROFFEN_MAX}, counting the remainder. */
export function capBetroffen(items: HinweisBetroffen[]): Pick<Hinweis, 'betroffen' | 'betroffenWeitere'> {
    if (items.length <= BETROFFEN_MAX) return { betroffen: items };
    return { betroffen: items.slice(0, BETROFFEN_MAX), betroffenWeitere: items.length - BETROFFEN_MAX };
}

/** A booking as the hint input carries it. */
export interface HinweisBuchung {
    id: string;
    bookingDate: string;
    amount: number;
    counterparty?: string;
    purpose?: string;
}

/** One unresolved double-payment suspicion (see invoices/doppelzahlung.ts). */
export interface HinweisDoppelzahlung {
    rechnungId: string;
    rechnungNummer: string;
    zuViel: number;
    txs: HinweisBuchung[];
}

export interface HinweiseInput {
    year: number;
    /** Net business turnover (Umsatz) for the year. */
    umsatz: number;
    /** Vereinnahmte USt — > 0 means VAT is charged (Regelbesteuerung). */
    outputVat: number;
    /** USt-Jahres figures, if the entity files USt. */
    uste?: { vatPayable: number; closingBalance: number; prepaidVat: number } | null;
    gewst?: { messbetrag: number } | null;
    /** Vorsteuer claimed without a linked invoice; `rows` are the affected bookings. */
    belegLuecke?: { count: number; sum: number; rows?: HinweisBuchung[] };
    /** Bookings classified neither by document nor rule. */
    unclassified?: number;
    /** Those bookings themselves, when known. */
    unclassifiedRows?: HinweisBuchung[];
    /** Last day of business if it ceased mid-year. */
    businessEndDate?: string;
    /** Net §24 nachträgliche Einkünfte folded into the result. */
    nachtraeglichNet?: number;
    /** Count of neutralised double payments. */
    doppelzahlungen?: number;
    /** Credits that look like a double / excess payment and no decision covers yet. */
    doppelzahlungVerdacht?: number;
    /** Those suspicions with their invoice, when known. */
    doppelzahlungVerdachtListe?: HinweisDoppelzahlung[];
    /** Recorded double payments whose refund to the customer is not linked yet. */
    rueckzahlungOffen?: number;
    /** Those double payments (the credit + its invoice), when known. */
    rueckzahlungOffenListe?: { txId: string; rechnungId?: string; zeile: string }[];
    /** Linear AfA folded into the EÜR + the number of depreciated assets. */
    afa?: number;
    afaCount?: number;
    /** Next annual-declaration filing deadline (YYYY-MM-DD) — the dashboard shows the countdown. */
    nextDeadline?: string;
}

const LEVEL_ORDER: Record<HinweisLevel, number> = { warnung: 0, tipp: 1, info: 2 };

/** §19 UStG Kleinunternehmer thresholds (raised for 2025: 25.000 / 100.000 €). */
function kleinunternehmerGrenzen(year: number): { vorjahr: number; laufend: number } {
    return year >= 2025 ? { vorjahr: 25_000, laufend: 100_000 } : { vorjahr: 22_000, laufend: 50_000 };
}

/** ISO `YYYY-MM-DD` → `DD.MM.YYYY`. */
function deDate(iso: string): string {
    const [y, m, d] = iso.slice(0, 10).split('-');
    return d && m && y ? `${d}.${m}.${y}` : iso;
}

export function computeHinweise(i: HinweiseInput): Hinweis[] {
    const h: Hinweis[] = [];
    const regelbesteuerung = i.outputVat > 0.005;
    const g = kleinunternehmerGrenzen(i.year);
    const KLEIN_REF = '§ 19 Abs. 1 UStG';

    // §19 Kleinunternehmer vs Regelbesteuerung.
    if (i.umsatz > g.laufend) {
        h.push({
            key: 'kleinunternehmer',
            level: 'warnung',
            title: _('Standard taxation is mandatory'),
            text: t(_('Revenue {year} {revenue} € above {limit} € — the small business scheme is ruled out.'), {
                year: i.year,
                revenue: fmt(i.umsatz),
                limit: fmt(g.laufend),
            }),
            ref: KLEIN_REF,
        });
    } else if (regelbesteuerung && i.umsatz <= g.vorjahr) {
        h.push({
            key: 'kleinunternehmer',
            level: 'tipp',
            title: _('The small business scheme would be possible'),
            text:
                t(_('Revenue {year} {revenue} € below {limit} € (previous-year limit).'), {
                    year: i.year,
                    revenue: fmt(i.umsatz),
                    limit: fmt(g.vorjahr),
                }) +
                ' ' +
                _(
                    'Currently standard taxation (VAT charged) — a switch to the small business scheme would be possible (no VAT, but no input tax deduction). Check whether it pays off.',
                ),
            ref: KLEIN_REF,
        });
    } else if (!regelbesteuerung && i.umsatz > g.vorjahr) {
        h.push({
            key: 'kleinunternehmer',
            level: 'warnung',
            title: _('Check the switch to standard taxation'),
            text: t(
                _(
                    'Revenue {year} {revenue} € above the previous-year limit {limit} € — the small business status may lapse.',
                ),
                { year: i.year, revenue: fmt(i.umsatz), limit: fmt(g.vorjahr) },
            ),
            ref: KLEIN_REF,
        });
    } else {
        h.push({
            key: 'kleinunternehmer',
            level: 'info',
            title: t(_('Type of taxation: {type}'), {
                type: regelbesteuerung ? _('standard taxation') : _('small business / no VAT'),
            }),
            text: t(
                _(
                    'Revenue {year} {revenue} €. Small business limits: {previous} € (previous year) · {current} € (current year).',
                ),
                { year: i.year, revenue: fmt(i.umsatz), previous: fmt(g.vorjahr), current: fmt(g.laufend) },
            ),
            ref: KLEIN_REF,
        });
    }

    // USt prepayments not yet recorded → the closing balance is overstated.
    if (i.uste && i.uste.prepaidVat === 0 && i.uste.vatPayable > 0.005) {
        h.push({
            key: 'ust-vorauszahlungen',
            level: 'warnung',
            title: _('VAT prepayments not recorded yet'),
            text: t(
                _(
                    'The advance VAT returns during the year are not entered — the closing payment ({amount} €) is reduced by the prepayments already made.',
                ),
                { amount: fmt(i.uste.closingBalance) },
            ),
        });
    }

    // Vorsteuer without a receipt.
    if (i.belegLuecke && i.belegLuecke.count > 0) {
        const rows = i.belegLuecke.rows ?? [];
        h.push({
            key: 'beleg-luecke',
            level: 'warnung',
            title: _('Input tax without a linked receipt'),
            text:
                t(
                    _n(
                        '{amount} € input tax in {n} booking without a stored invoice.',
                        '{amount} € input tax in {n} bookings without a stored invoice.',
                        i.belegLuecke.count,
                    ),
                    { amount: fmt(i.belegLuecke.sum), n: i.belegLuecke.count },
                ) +
                ' ' +
                _(
                    'To deduct the input tax, keep the invoices and present them on request by the tax office (not to be transmitted to ELSTER).',
                ),
            status: 'befund',
            ...(rows.length
                ? {
                      ...capBetroffen(rows.map((r) => ({ art: 'buchung', id: r.id, zeile: buchungZeile(r) }))),
                      fingerprint: hinweisFingerprint(rows.map((r) => r.id)),
                      handlungen: [
                          {
                              id: 'zuordnen',
                              label: _('Match'),
                              target: { art: 'dialog', dialog: 'beleg-zuordnen', ref: rows[0].id },
                          },
                          {
                              id: 'offene-belege',
                              label: _('Open the receipt inbox'),
                              target: { art: 'ansicht', ansicht: 'beleg-eingang', filter: 'ohne-beleg' },
                          },
                          handlungInOrdnung(),
                      ],
                  }
                : {}),
        });
    }

    // Unclassified bookings.
    if (i.unclassified && i.unclassified > 0) {
        const rows = i.unclassifiedRows ?? [];
        h.push({
            key: 'unklassifiziert',
            level: 'warnung',
            title: t(_n('{n} unclassified booking', '{n} unclassified bookings', i.unclassified), {
                n: i.unclassified,
            }),
            text: _(
                'These bookings are assigned neither through a receipt nor through a rule — clarify before filing.',
            ),
            status: 'befund',
            ...(rows.length
                ? {
                      ...capBetroffen(rows.map((r) => ({ art: 'buchung', id: r.id, zeile: buchungZeile(r) }))),
                      fingerprint: hinweisFingerprint(rows.map((r) => r.id)),
                      handlungen: [
                          {
                              id: 'regel-anlegen',
                              label: _('Create a rule'),
                              target: { art: 'dialog', dialog: 'regel-anlegen', ref: rows[0].id },
                          },
                          {
                              id: 'buchungen',
                              label: _('Open transactions'),
                              target: { art: 'ansicht', ansicht: 'buchungen', filter: 'unklassifiziert' },
                          },
                          handlungInOrdnung(),
                      ],
                  }
                : {}),
        });
    }

    // Betriebsaufgabe / §24.
    if (i.businessEndDate) {
        h.push({
            key: 'betriebsaufgabe',
            level: 'info',
            title: _('Business ceased during the year'),
            text:
                t(_('Business ceased on {date}.'), { date: deDate(i.businessEndDate) }) +
                (i.nachtraeglichNet
                    ? ' ' +
                      t(_('Subsequent § 24 income of {amount} € is included in the result (exempt from trade tax).'), {
                          amount: fmt(i.nachtraeglichNet),
                      })
                    : ''),
            ref: '§ 16 / § 24 EStG',
        });
    }

    // Unresolved suspicion / open refund: money that belongs to the customer must not slip into revenue.
    // The decision itself lives at the invoice (Rechnungsdetail), so these hints link there instead
    // of offering their own „in Ordnung" — idea 5 already stores that one per credit.
    if (i.doppelzahlungVerdacht && i.doppelzahlungVerdacht > 0) {
        const liste = i.doppelzahlungVerdachtListe ?? [];
        const betroffen: HinweisBetroffen[] = liste.flatMap((v) => [
            {
                art: 'rechnung' as const,
                id: v.rechnungId,
                zeile: t(_('Invoice {number} · {amount} € too much'), {
                    number: v.rechnungNummer,
                    amount: fmt(v.zuViel),
                }),
            },
            ...v.txs.map((t) => ({ art: 'buchung' as const, id: t.id, zeile: buchungZeile(t) })),
        ]);
        h.push({
            key: 'doppelzahlung-verdacht',
            level: 'warnung',
            title: t(
                _n(
                    '{n} payment possibly received twice — clarify before filing',
                    '{n} payments possibly received twice — clarify before filing',
                    i.doppelzahlungVerdacht,
                ),
                { n: i.doppelzahlungVerdacht },
            ),
            text: _(
                'A customer has apparently paid an invoice more than once or too much. The excess received is not revenue but an obligation to repay — confirm it or mark it as fine.',
            ),
            status: 'befund',
            ...(liste.length
                ? {
                      ...capBetroffen(betroffen),
                      handlungen: [
                          {
                              id: 'rechnung',
                              label: _('Open the invoice'),
                              target: { art: 'dialog', dialog: 'rechnung', ref: liste[0].rechnungId },
                          },
                      ],
                  }
                : {}),
        });
    }
    if (i.rueckzahlungOffen && i.rueckzahlungOffen > 0) {
        const liste = i.rueckzahlungOffenListe ?? [];
        const mitRechnung = liste.find((r) => r.rechnungId);
        h.push({
            key: 'doppelzahlung-rueckzahlung-offen',
            level: 'warnung',
            title: t(
                _n(
                    '{n} double payment not refunded to the customer yet',
                    '{n} double payments not refunded to the customer yet',
                    i.rueckzahlungOffen,
                ),
                { n: i.rueckzahlungOffen },
            ),
            text: _(
                'Once the refund is booked, link the transfer to the double payment — it is then treated as a pass-through item as well.',
            ),
            status: 'befund',
            ...(liste.length
                ? {
                      ...capBetroffen(liste.map((r) => ({ art: 'buchung' as const, id: r.txId, zeile: r.zeile }))),
                      ...(mitRechnung
                          ? {
                                handlungen: [
                                    {
                                        id: 'rechnung',
                                        label: _('Open the invoice'),
                                        target: {
                                            art: 'dialog' as const,
                                            dialog: 'rechnung' as const,
                                            ref: mitRechnung.rechnungId,
                                        },
                                    },
                                ],
                            }
                          : {}),
                  }
                : {}),
        });
    }

    // Neutralised double payments.
    if (i.doppelzahlungen && i.doppelzahlungen > 0) {
        h.push({
            key: 'doppelzahlungen',
            level: 'info',
            title: t(_n('{n} double payment neutralised', '{n} double payments neutralised', i.doppelzahlungen), {
                n: i.doppelzahlungen,
            }),
            text: _(
                'Invoices paid twice are excluded from revenue and VAT as a pass-through item (obligation to repay).',
            ),
        });
    }

    // AfA reminder — keep the Anlageverzeichnis current.
    if (i.afa && i.afa > 0.005) {
        h.push({
            key: 'afa',
            level: 'info',
            title: _('Depreciation taken into account'),
            text: t(
                _(
                    'Depreciation of {amount} €{assets} is included in the EÜR — keep the asset register (residual values, additions/disposals) up to date.',
                ),
                {
                    amount: fmt(i.afa),
                    assets: i.afaCount
                        ? t(_n(' from {n} fixed asset', ' from {n} fixed assets', i.afaCount), { n: i.afaCount })
                        : '',
                },
            ),
        });
    }

    // Next filing deadline (the Steuer-Dashboard shows the live "in N Tagen").
    if (i.nextDeadline) {
        h.push({
            key: 'frist',
            level: 'info',
            title: _('Next filing deadline'),
            text: t(
                _(
                    'The annual returns are due by {date} (regular deadline without an adviser; a granted extension moves it).',
                ),
                { date: deDate(i.nextDeadline) },
            ),
        });
    }

    // GewSt below the Freibetrag.
    if (i.gewst && i.gewst.messbetrag === 0) {
        h.push({
            key: 'gewst-null',
            level: 'info',
            title: _('Trade tax: base amount 0 €'),
            text: _(
                'The trade income is below the allowance (24,500 €) — no trade tax is due, but the return still has to be filed.',
            ),
        });
    }

    return sortHinweise(h);
}

/** {@link Hinweis.vorrang} first, then most urgent (warnung > tipp > info); stable within a level. */
export function sortHinweise<T extends Hinweis>(h: T[]): T[] {
    const rank = (x: Hinweis) => (x.vorrang ? -1 : LEVEL_ORDER[x.level]);
    return h.sort((a, b) => rank(a) - rank(b));
}
